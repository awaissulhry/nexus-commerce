/**
 * RX.6a — defect → recall intelligence (migration-free).
 *
 * The recall-signal half of the warranty/defect track, derived from
 * data we already have: a ReturnItem is a "defect signal" when it's
 * graded DAMAGED/UNUSABLE or dispositioned SCRAP/QUARANTINE. We cluster
 * those by product and surface products with a defect cluster as recall
 * candidates, listing the product's active lots so the operator can
 * open a recall on the right batch via the existing L-series workflow.
 *
 * Lot-PRECISE linkage (which exact lot a defect unit came from) needs
 * ReturnItem.lotId — that arrives with the gated warranty-track
 * migration. Until then this is product-level, which is already enough
 * to flag "this helmet model is coming back broken — check its lots".
 */

import prisma from '../db.js'

export interface RecallCandidateLot {
  id: string
  lotNumber: string
  unitsRemaining: number
  hasOpenRecall: boolean
}

export interface RecallCandidate {
  productId: string
  sku: string | null
  name: string | null
  defectReturnCount: number
  totalReturnCount: number
  defectRatePct: number | null
  lots: RecallCandidateLot[]
  flagged: boolean
}

export interface DefectRecallSummary {
  windowDays: number
  minDefectCount: number
  candidates: RecallCandidate[]
  generatedAt: string
}

const DEFECT_GRADES = ['DAMAGED', 'UNUSABLE'] as const
const DEFECT_DISPOSITIONS = ['SCRAP', 'QUARANTINE'] as const

export async function computeDefectRecallSignals(opts?: { windowDays?: number }): Promise<DefectRecallSummary> {
  const windowDays = Math.max(7, Math.min(365, opts?.windowDays ?? 90))
  const since = new Date(Date.now() - windowDays * 86_400_000)
  const MIN_DEFECT = Math.max(1, Number(process.env.NEXUS_RETURNS_DEFECT_RECALL_MIN) || 2)

  const [defectByProduct, totalByProduct] = await Promise.all([
    prisma.returnItem.groupBy({
      by: ['productId'],
      _count: { _all: true },
      where: {
        productId: { not: null },
        return: { createdAt: { gte: since } },
        OR: [
          { conditionGrade: { in: DEFECT_GRADES as unknown as string[] as any } },
          { disposition: { in: DEFECT_DISPOSITIONS as unknown as string[] } },
        ],
      },
    }),
    prisma.returnItem.groupBy({
      by: ['productId'],
      _count: { _all: true },
      where: { productId: { not: null }, return: { createdAt: { gte: since } } },
    }),
  ])

  const totalMap = new Map<string, number>(
    totalByProduct.filter((r) => r.productId).map((r) => [r.productId as string, r._count._all]),
  )

  const productIds = defectByProduct.map((r) => r.productId).filter((x): x is string => !!x)
  if (productIds.length === 0) {
    return { windowDays, minDefectCount: MIN_DEFECT, candidates: [], generatedAt: new Date().toISOString() }
  }

  const [products, lots] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, sku: true, name: true },
    }),
    prisma.lot.findMany({
      where: { productId: { in: productIds }, unitsRemaining: { gt: 0 } },
      select: {
        id: true, productId: true, lotNumber: true, unitsRemaining: true,
        recalls: { where: { status: 'OPEN' }, select: { id: true } },
      },
      orderBy: { receivedAt: 'desc' },
    }),
  ])

  const productMap = new Map(products.map((p) => [p.id, p]))
  const lotsByProduct = new Map<string, RecallCandidateLot[]>()
  for (const l of lots) {
    const arr = lotsByProduct.get(l.productId) ?? []
    arr.push({
      id: l.id,
      lotNumber: l.lotNumber,
      unitsRemaining: l.unitsRemaining,
      hasOpenRecall: l.recalls.length > 0,
    })
    lotsByProduct.set(l.productId, arr)
  }

  const candidates: RecallCandidate[] = defectByProduct
    .filter((r) => r.productId)
    .map((r) => {
      const pid = r.productId as string
      const defectCount = r._count._all
      const total = totalMap.get(pid) ?? defectCount
      const p = productMap.get(pid)
      return {
        productId: pid,
        sku: p?.sku ?? null,
        name: p?.name ?? null,
        defectReturnCount: defectCount,
        totalReturnCount: total,
        defectRatePct: total > 0 ? (defectCount / total) * 100 : null,
        lots: lotsByProduct.get(pid) ?? [],
        flagged: defectCount >= MIN_DEFECT,
      }
    })
    .sort((a, b) => b.defectReturnCount - a.defectReturnCount)

  return {
    windowDays,
    minDefectCount: MIN_DEFECT,
    candidates,
    generatedAt: new Date().toISOString(),
  }
}
