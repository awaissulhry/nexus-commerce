/**
 * R4.1 — bulk cost entry (docs/AMAZON_DATA_STRATEGY.md).
 *
 * The COGS overlay's data side: the profit calc + replenishment engine
 * already read Product.costPrice — they just have nothing to read (0/265
 * SKUs have cost). This powers an in-app grid to load it fast, with a live
 * TRUE-margin preview using the real Amazon fee rate (R1), so the operator
 * sees real margin as they type cost.
 *
 * Writes Product.costPrice (EUR). User-initiated data entry.
 */

import prisma from '../db.js'
import { getRealCombinedRateByMarketplace } from './amazon-real-fees.service.js'

const DAY = 86_400_000

export interface CostGridRow {
  id: string
  sku: string
  name: string
  basePrice: number | null
  costPrice: number | null
  unitsSold90d: number
}

export interface CostGrid {
  /** Real blended Amazon fee rate (% of selling price) for the margin preview. */
  amazonFeePct: number | null
  /** How many active SKUs still have no cost. */
  missingCost: number
  products: CostGridRow[]
}

export async function getCostGrid(): Promise<CostGrid> {
  const since = new Date(Date.now() - 90 * DAY)
  const sales = await prisma.orderItem.groupBy({
    by: ['productId'],
    where: {
      productId: { not: null },
      order: { channel: 'AMAZON', purchaseDate: { gte: since } },
    },
    _sum: { quantity: true },
  })
  const unitsByProduct = new Map<string, number>()
  for (const s of sales)
    if (s.productId) unitsByProduct.set(s.productId, s._sum.quantity ?? 0)

  const products = await prisma.product.findMany({
    where: { deletedAt: null, status: 'ACTIVE', parentId: null },
    select: { id: true, sku: true, name: true, basePrice: true, costPrice: true },
  })
  const real = await getRealCombinedRateByMarketplace(90).catch(() => null)

  const rows: CostGridRow[] = products
    .map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      basePrice: p.basePrice != null ? Number(p.basePrice) : null,
      costPrice: p.costPrice != null ? Number(p.costPrice) : null,
      unitsSold90d: unitsByProduct.get(p.id) ?? 0,
    }))
    // Most-sold first — that's where loading cost matters most.
    .sort((a, b) => b.unitsSold90d - a.unitsSold90d || a.sku.localeCompare(b.sku))

  return {
    amazonFeePct: real?.blendedPct ?? null,
    missingCost: rows.filter((r) => r.costPrice == null).length,
    products: rows,
  }
}

export async function bulkSetCosts(
  updates: { productId: string; costPrice: number | null }[],
): Promise<{ updated: number; skipped: number }> {
  let updated = 0
  let skipped = 0
  for (const u of updates) {
    if (!u.productId) {
      skipped++
      continue
    }
    const value =
      u.costPrice != null && Number.isFinite(u.costPrice) && u.costPrice >= 0
        ? u.costPrice.toFixed(2)
        : null
    await prisma.product
      .update({ where: { id: u.productId }, data: { costPrice: value } })
      .then(() => updated++)
      .catch(() => skipped++)
  }
  return { updated, skipped }
}
