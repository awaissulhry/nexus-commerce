/**
 * SD reports below the campaign (2026-10-20) — the ingest of the four Sponsored Display reports under the campaign
 * (sd-reports.ts), called by `ingestCompletedJob` (ads-reports.service.ts) once it has downloaded, parsed and dropped the
 * days a newer pull already wrote.
 *
 *   ad group / target / product ad  → AmazonAdsSdDailyPerformance, upserted on (profile, entity, day): a re-pull of a
 *                                     day replaces its row, never adds one. Joined to the local AdGroup / AdTarget /
 *                                     AdProductAd by Amazon's id; a row Nexus holds no entity for is still stored
 *                                     (localEntityId null): the spend was real.
 *   purchased product               → AmazonAdsSdPurchasedProduct. No unique key (as search terms): the older copy of
 *                                     each day this pull holds is deleted and this pull's rows inserted in one
 *                                     transaction, so a day never counts twice; a day this pull has no row for is left.
 */
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { sdDailyRowOf, sdPurchasedRowOf, type SdDailyRow, type SdEntityType, type SdReportRow } from './sd-reports.js'

interface IngestJob {
  id: string
  profileId: string
  reportTypeId: string
}

type LocalOf = (row: SdDailyRow) => Promise<string | null>

/** One lookup per Amazon id per ingest (a ranged pull names each entity once per day). */
function localResolver(entityType: SdEntityType): LocalOf {
  const cache = new Map<string, Promise<string | null>>()
  const find = (key: string, work: () => Promise<{ id: string } | null>) => {
    let hit = cache.get(key)
    if (!hit) {
      hit = work().then((row) => row?.id ?? null)
      cache.set(key, hit)
    }
    return hit
  }
  if (entityType === 'AD_GROUP') {
    return (row) => find(row.entityId, () => prisma.adGroup.findFirst({ where: { externalAdGroupId: row.entityId }, select: { id: true } }))
  }
  if (entityType === 'AD_TARGET') {
    return (row) => find(row.entityId, () => prisma.adTarget.findFirst({ where: { externalTargetId: row.entityId }, select: { id: true } }))
  }
  // A product ad Nexus has not linked to Amazon's ad id yet is found by its ASIN in the same Amazon ad group.
  return (row) => find(`${row.entityId}|${row.adGroupId ?? ''}|${row.promotedAsin ?? ''}`, async () =>
    (await prisma.adProductAd.findFirst({ where: { externalAdId: row.entityId }, select: { id: true } }))
    ?? (row.promotedAsin && row.adGroupId
      ? prisma.adProductAd.findFirst({ where: { asin: row.promotedAsin, adGroup: { externalAdGroupId: row.adGroupId } }, select: { id: true } })
      : null))
}

/** sdAdGroup / sdTargeting / sdAdvertisedProduct rows → AmazonAdsSdDailyPerformance. Returns the rows written. */
export async function ingestSdEntityRows(job: IngestJob, rows: readonly SdReportRow[], marketplace: string, currencyCode: string): Promise<number> {
  const parsed = rows.map((r) => sdDailyRowOf(job.reportTypeId, r)).filter((r): r is SdDailyRow => r != null)
  if (parsed.length < rows.length) {
    logger.warn('[sd-reports] rows with no day, campaign or entity id are not stored', { jobId: job.id, reportTypeId: job.reportTypeId, skipped: rows.length - parsed.length })
  }
  if (!parsed.length) return 0
  const localOf = localResolver(parsed[0].entityType)
  let written = 0
  for (const row of parsed) {
    const { date, entityType, entityId, ...rest } = row
    const data = { ...rest, marketplace, currencyCode, localEntityId: await localOf(row), reportRunId: job.id, reportedAt: new Date() }
    try {
      await prisma.amazonAdsSdDailyPerformance.upsert({
        where: { sd_daily_entity: workspaceKey({ profileId: job.profileId, entityType, entityId, date }) },
        create: { profileId: job.profileId, entityType, entityId, date, ...data },
        update: data,
      })
      written += 1
    } catch (err) {
      logger.warn('[sd-reports] row not written', { jobId: job.id, entityType, entityId, error: String(err).slice(0, 200) })
    }
  }
  return written
}

/** sdPurchasedProduct rows → AmazonAdsSdPurchasedProduct, each day this pull holds replacing its older copy. */
export async function ingestSdPurchasedProductRows(job: IngestJob, rows: readonly SdReportRow[], marketplace: string, currencyCode: string): Promise<number> {
  const parsed = rows.map(sdPurchasedRowOf).filter((r): r is NonNullable<typeof r> => r != null)
  if (parsed.length < rows.length) {
    logger.warn('[sd-reports] purchased-product rows with no day, campaign, ad group or ASIN are not stored', { jobId: job.id, skipped: rows.length - parsed.length })
  }
  if (!parsed.length) return 0
  const days = [...new Set(parsed.map((r) => r.date.toISOString().slice(0, 10)))].map((d) => new Date(`${d}T00:00:00.000Z`))
  const result = await prisma.$transaction(async (tx) => {
    // Every older copy of these days, this job's own included (an ingest run again writes its rows again).
    const replaced = await tx.amazonAdsSdPurchasedProduct.deleteMany({ where: { profileId: job.profileId, date: { in: days } } })
    if (replaced.count > 0) logger.info('[sd-reports] purchased-product days re-read: the older copy is replaced', { jobId: job.id, rowsReplaced: replaced.count, days: days.length })
    return tx.amazonAdsSdPurchasedProduct.createMany({
      data: parsed.map((r) => ({ ...r, profileId: job.profileId, marketplace, currencyCode, reportRunId: job.id })),
    })
  })
  return result.count
}
