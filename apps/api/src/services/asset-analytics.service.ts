/**
 * MC.13.4 — Asset usage analytics service.
 *
 * Single roundtrip behind /api/assets/analytics. Aggregates the data
 * we need for the storage analytics dashboard (MC.13.5):
 *
 *   - topUsed:         the 10 most-referenced DigitalAssets
 *   - typeBreakdown:   asset count + bytes per type
 *   - formatBreakdown: top 10 image/video formats by count
 *   - uploadVolume:    new-asset count for last 7 / 30 / 90 days
 *   - orphanedCount:   assets with zero AssetUsage rows
 *   - averageBytes:    mean asset size across the workspace
 *   - cloudinaryDeletes: count of out-of-band deletions (from
 *     CLOUDINARY_WEBHOOK_DELETE audit rows)
 *
 * Everything is computed in parallel — the hub is read-mostly so we
 * trade a slightly heavier query for a single front-end fetch.
 */

import prisma from '../db.js'

export interface AssetAnalytics {
  totalAssets: number
  averageBytes: number
  orphanedCount: number
  cloudinaryDeletes: number
  topUsed: Array<{
    id: string
    label: string
    url: string
    type: string
    usageCount: number
  }>
  typeBreakdown: Array<{
    type: string
    count: number
    bytes: number
  }>
  formatBreakdown: Array<{
    format: string
    count: number
  }>
  uploadVolume: {
    last7Days: number
    last30Days: number
    last90Days: number
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

export async function computeAssetAnalytics(): Promise<AssetAnalytics> {
  const now = Date.now()
  const cutoff7 = new Date(now - 7 * DAY_MS)
  const cutoff30 = new Date(now - 30 * DAY_MS)
  const cutoff90 = new Date(now - 90 * DAY_MS)

  const [
    totalAssets,
    sizeAgg,
    typeRows,
    last7,
    last30,
    last90,
    deleteAudits,
    usageGroup,
    formatRows,
  ] = await Promise.all([
    prisma.digitalAsset.count(),
    prisma.digitalAsset.aggregate({ _avg: { sizeBytes: true } }),
    prisma.digitalAsset.groupBy({
      by: ['type'],
      _count: { _all: true },
      _sum: { sizeBytes: true },
    }),
    prisma.digitalAsset.count({ where: { createdAt: { gte: cutoff7 } } }),
    prisma.digitalAsset.count({ where: { createdAt: { gte: cutoff30 } } }),
    prisma.digitalAsset.count({ where: { createdAt: { gte: cutoff90 } } }),
    prisma.auditLog.count({
      where: { action: 'CLOUDINARY_WEBHOOK_DELETE' },
    }),
    prisma.assetUsage.groupBy({
      by: ['assetId'],
      _count: { _all: true },
      orderBy: { _count: { assetId: 'desc' } },
      take: 10,
    }),
    // Format histogram via raw SQL — Prisma's groupBy can't traverse
    // into the metadata JSON, but we get the file extension from the
    // url cheaply with regexp.
    prisma.$queryRaw<Array<{ format: string; count: bigint }>>`
      SELECT lower(regexp_replace(split_part(url, '?', 1), '.*\\.', '')) AS format,
             count(*)::bigint AS count
      FROM "DigitalAsset"
      WHERE url IS NOT NULL
      GROUP BY format
      ORDER BY count DESC
      LIMIT 10
    `,
  ])

  // Resolve the top 10 used asset rows for labels.
  const topUsedIds = usageGroup.map((row) => row.assetId)
  const topUsedAssets = topUsedIds.length
    ? await prisma.digitalAsset.findMany({
        where: { id: { in: topUsedIds } },
        select: { id: true, label: true, url: true, type: true },
      })
    : []
  const topUsedById = new Map(topUsedAssets.map((a) => [a.id, a]))
  const topUsed = usageGroup
    .map((row) => {
      const asset = topUsedById.get(row.assetId)
      if (!asset) return null
      return {
        id: asset.id,
        label: asset.label,
        url: asset.url,
        type: asset.type,
        usageCount: row._count._all,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  // Orphaned = total minus distinct asset ids that appear in usage.
  const distinctUsed = await prisma.assetUsage.findMany({
    select: { assetId: true },
    distinct: ['assetId'],
  })
  const orphanedCount = Math.max(totalAssets - distinctUsed.length, 0)

  return {
    totalAssets,
    averageBytes: Math.round(sizeAgg._avg.sizeBytes ?? 0),
    orphanedCount,
    cloudinaryDeletes: deleteAudits,
    topUsed,
    typeBreakdown: typeRows.map((row) => ({
      type: row.type,
      count: row._count._all,
      bytes: row._sum.sizeBytes ?? 0,
    })),
    formatBreakdown: formatRows.map((row) => ({
      format: row.format || '(unknown)',
      count: Number(row.count),
    })),
    uploadVolume: {
      last7Days: last7,
      last30Days: last30,
      last90Days: last90,
    },
  }
}
