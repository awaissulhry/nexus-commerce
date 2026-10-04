/**
 * IR.9.4 — the photo publish jobs of one product, across Amazon (image feeds) and eBay + Shopify, newest first.
 *
 * Moved out of `routes/images/channel-image-publish.routes.ts` (GET /api/products/:productId/image-publish-jobs) with
 * no change in behaviour, so the publish history (sheet publish parity, step 4) reads the same per-SKU receipt.
 */
import prisma from '../../db.js'

export interface UnifiedJob {
  id: string
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY'
  marketplace: string | null
  status: string
  errorMessage: string | null
  vendorEntityId: string | null
  submittedAt: string
  completedAt: string | null
  // IA.3 — Per-SKU receipt from Amazon's processing report. Only
  // populated on AMAZON jobs once feed-status reaches DONE. Shape:
  // { perSku: [{ sku, asin, accepted, errors }] } embedded in
  // AmazonImageFeedJob.resultSummary.
  perSku?: AmazonImagePerSku[]
}

export interface AmazonImagePerSku {
  sku: string
  asin: string | null
  accepted: boolean
  errors: Array<{ code: string; message: string }>
}

/**
 * IA.3 — the per-SKU receipt stored on `AmazonImageFeedJob.resultSummary`. The raw summary may include other Amazon
 * fields; only `perSku` is exposed.
 */
export function amazonImagePerSku(resultSummary: unknown): AmazonImagePerSku[] | undefined {
  const rs = resultSummary as { perSku?: AmazonImagePerSku[] } | null
  return rs?.perSku
}

export async function listProductImagePublishJobs(productId: string, limit: number): Promise<UnifiedJob[]> {
  const [amazonJobs, channelJobs] = await Promise.all([
    prisma.amazonImageFeedJob.findMany({
      where: { productId },
      orderBy: { submittedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        marketplace: true,
        status: true,
        errorMessage: true,
        feedId: true,
        submittedAt: true,
        completedAt: true,
        // IA.3 — pull resultSummary so the FE can render per-SKU
        // receipts without a second round-trip per job.
        resultSummary: true,
      },
    }),
    prisma.channelImagePublishJob.findMany({
      where: { productId },
      orderBy: { submittedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        channel: true,
        marketplace: true,
        status: true,
        errorMessage: true,
        vendorEntityId: true,
        submittedAt: true,
        completedAt: true,
      },
    }),
  ])

  return [
    ...amazonJobs.map((j): UnifiedJob => ({
      id: j.id,
      channel: 'AMAZON',
      marketplace: j.marketplace,
      status: j.status,
      errorMessage: j.errorMessage,
      vendorEntityId: j.feedId,
      submittedAt: j.submittedAt.toISOString(),
      completedAt: j.completedAt?.toISOString() ?? null,
      perSku: amazonImagePerSku(j.resultSummary),
    })),
    ...channelJobs.map((j): UnifiedJob => ({
      id: j.id,
      channel: j.channel as 'EBAY' | 'SHOPIFY',
      marketplace: j.marketplace,
      status: j.status,
      errorMessage: j.errorMessage,
      vendorEntityId: j.vendorEntityId,
      submittedAt: j.submittedAt.toISOString(),
      completedAt: j.completedAt?.toISOString() ?? null,
    })),
  ]
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
    .slice(0, limit)
}
