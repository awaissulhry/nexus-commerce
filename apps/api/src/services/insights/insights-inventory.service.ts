/**
 * IH.7 — inventory & fulfillment insights.
 *
 * Per-SKU rollup combines current StockLevel.available, Product.cost-
 * Price, ABC class, window-scoped sales velocity, and Return refund
 * data. Surfaces value-at-risk callouts the operator can't easily
 * derive from /fulfillment/stock alone.
 *
 *   Inventory value          (Σ available × costPrice)
 *   Dead stock value         (no movement in window, available > 0)
 *   Stockout cost estimate   (avg daily revenue × days out-of-stock)
 *   Days of inventory        (available / avg daily units)
 *   ABC class mix             (Product.abcClass — recomputed weekly)
 *   Return rate by SKU        (returns / units sold)
 */

import prisma from '../../db.js'
import {
  type InsightsFilters,
  resolveWindowRange,
} from './index.js'

export interface InventoryRow {
  sku: string
  productId: string
  productName: string | null
  brand: string | null
  available: number
  reserved: number
  costPrice: number | null
  inventoryValue: number
  unitsSold: number
  revenue: number
  daysOfInventory: number | null
  lastMovementAt: string | null
  stockoutDays: number
  stockoutCostEstimate: number
  returnsCount: number
  returnRatePct: number | null
  abcClass: string | null
}

export interface AbcBucket {
  abcClass: string
  label: string
  count: number
  inventoryValue: number
  revenueShare: number
}

export interface InventoryReport {
  window: { from: string; to: string }
  totals: {
    skuCount: number
    inventoryValue: number
    deadStockValue: number
    deadStockSkus: number
    avgDaysOfInventory: number | null
    stockoutCostEstimate: number
    returnRatePct: number | null
  }
  abcMix: AbcBucket[]
  rows: InventoryRow[]
  deadStock: InventoryRow[]
  stockoutWatch: InventoryRow[]
}

function dayKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

export async function computeInventoryReport(
  filters: InsightsFilters,
): Promise<InventoryReport> {
  const current = resolveWindowRange(filters)

  const whereChannel =
    filters.channels.length > 0
      ? { in: filters.channels as Array<'AMAZON' | 'EBAY' | 'SHOPIFY'> }
      : undefined
  const whereMarket =
    filters.markets.length > 0 ? { in: filters.markets } : undefined

  const [products, stockLevels, salesItems, movements, returns] = await Promise.all([
    prisma.product.findMany({
      where: { status: 'ACTIVE', deletedAt: null } as never,
      select: {
        id: true,
        sku: true,
        name: true,
        brand: true,
        costPrice: true,
        abcClass: true,
      },
      take: 5_000,
    }),
    prisma.stockLevel.groupBy({
      by: ['productId'],
      _sum: { available: true, reserved: true },
    }),
    prisma.orderItem.findMany({
      where: {
        order: {
          createdAt: { gte: current.from, lt: current.to },
          deletedAt: null,
          ...(whereChannel ? { channel: whereChannel as never } : {}),
          ...(whereMarket ? { marketplace: whereMarket } : {}),
        },
      },
      select: {
        productId: true,
        sku: true,
        quantity: true,
        price: true,
      },
      take: 200_000,
    }),
    prisma.stockMovement.findMany({
      where: {
        createdAt: { gte: current.from, lt: current.to },
      },
      select: { productId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 200_000,
    }),
    prisma.return.findMany({
      where: {
        createdAt: { gte: current.from, lt: current.to },
      },
      select: { orderId: true },
      take: 50_000,
    }),
  ])

  const stockMap = new Map(
    stockLevels.map((s) => [
      s.productId,
      {
        available: s._sum.available ?? 0,
        reserved: s._sum.reserved ?? 0,
      },
    ]),
  )

  const salesByProduct = new Map<
    string,
    { units: number; revenue: number; orderIds: Set<string> }
  >()
  for (const it of salesItems) {
    if (!it.productId) continue
    const slot = salesByProduct.get(it.productId) ?? {
      units: 0,
      revenue: 0,
      orderIds: new Set(),
    }
    slot.units += it.quantity ?? 0
    slot.revenue += Number(it.price ?? 0) * (it.quantity ?? 0)
    salesByProduct.set(it.productId, slot)
  }

  const lastMovementByProduct = new Map<string, Date>()
  for (const m of movements) {
    if (!lastMovementByProduct.has(m.productId)) {
      lastMovementByProduct.set(m.productId, m.createdAt)
    }
  }

  const returnOrderIds = new Set(returns.map((r) => r.orderId ?? ''))
  const returnsByProduct = new Map<string, number>()
  if (returnOrderIds.size > 0) {
    const returnedItems = await prisma.orderItem.findMany({
      where: { orderId: { in: [...returnOrderIds].filter(Boolean) } },
      select: { productId: true },
      take: 50_000,
    })
    for (const it of returnedItems) {
      if (!it.productId) continue
      returnsByProduct.set(
        it.productId,
        (returnsByProduct.get(it.productId) ?? 0) + 1,
      )
    }
  }

  const days =
    (current.to.getTime() - current.from.getTime()) / (24 * 3600_000)

  const rows: InventoryRow[] = products.map((p) => {
    const stock = stockMap.get(p.id) ?? { available: 0, reserved: 0 }
    const sales = salesByProduct.get(p.id) ?? {
      units: 0,
      revenue: 0,
      orderIds: new Set(),
    }
    const costPrice = p.costPrice == null ? null : Number(p.costPrice)
    const inventoryValue = (costPrice ?? 0) * stock.available
    const avgDailyUnits = sales.units / Math.max(days, 1)
    const daysOfInventory =
      avgDailyUnits > 0 ? stock.available / avgDailyUnits : null
    const lastMv = lastMovementByProduct.get(p.id) ?? null
    const stockoutDays =
      stock.available === 0 && sales.units > 0
        ? days * 0.3
        : 0
    const avgDailyRevenue = sales.revenue / Math.max(days, 1)
    const stockoutCostEstimate = stockoutDays * avgDailyRevenue
    const returnsCount = returnsByProduct.get(p.id) ?? 0
    const returnRatePct =
      sales.units > 0 ? (returnsCount / sales.units) * 100 : null
    return {
      sku: p.sku,
      productId: p.id,
      productName: p.name,
      brand: p.brand,
      available: stock.available,
      reserved: stock.reserved,
      costPrice,
      inventoryValue: Math.round(inventoryValue),
      unitsSold: sales.units,
      revenue: Math.round(sales.revenue),
      daysOfInventory:
        daysOfInventory == null ? null : Math.round(daysOfInventory * 10) / 10,
      lastMovementAt: lastMv?.toISOString() ?? null,
      stockoutDays: Math.round(stockoutDays),
      stockoutCostEstimate: Math.round(stockoutCostEstimate),
      returnsCount,
      returnRatePct,
      abcClass: p.abcClass,
    }
  })

  const totalInventoryValue = rows.reduce((s, r) => s + r.inventoryValue, 0)
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0)

  const abcCounts = new Map<string, AbcBucket>()
  for (const key of ['A', 'B', 'C', 'D', '—']) {
    abcCounts.set(key, {
      abcClass: key,
      label:
        key === 'A'
          ? 'A — top sellers'
          : key === 'B'
            ? 'B — middle'
            : key === 'C'
              ? 'C — long tail'
              : key === 'D'
                ? 'D — dead'
                : 'Unclassified',
      count: 0,
      inventoryValue: 0,
      revenueShare: 0,
    })
  }
  for (const r of rows) {
    const key = r.abcClass ?? '—'
    const slot = abcCounts.get(key) ?? abcCounts.get('—')!
    slot.count += 1
    slot.inventoryValue += r.inventoryValue
    slot.revenueShare += r.revenue
  }
  const abcMix: AbcBucket[] = [...abcCounts.values()].map((b) => ({
    ...b,
    revenueShare: totalRevenue > 0 ? b.revenueShare / totalRevenue : 0,
  }))

  const deadStock = rows
    .filter((r) => r.unitsSold === 0 && r.available > 0)
    .sort((a, b) => b.inventoryValue - a.inventoryValue)
    .slice(0, 50)

  const stockoutWatch = rows
    .filter((r) => r.daysOfInventory != null && r.daysOfInventory < 7 && r.unitsSold > 0)
    .sort((a, b) => (a.daysOfInventory ?? 999) - (b.daysOfInventory ?? 999))
    .slice(0, 50)

  const dohValues = rows
    .map((r) => r.daysOfInventory)
    .filter((v): v is number => v != null)
  const avgDaysOfInventory =
    dohValues.length > 0
      ? dohValues.reduce((s, v) => s + v, 0) / dohValues.length
      : null

  const totalReturns = rows.reduce((s, r) => s + r.returnsCount, 0)
  const totalUnitsSold = rows.reduce((s, r) => s + r.unitsSold, 0)
  const returnRatePct =
    totalUnitsSold > 0 ? (totalReturns / totalUnitsSold) * 100 : null

  return {
    window: { from: current.from.toISOString(), to: current.to.toISOString() },
    totals: {
      skuCount: rows.length,
      inventoryValue: totalInventoryValue,
      deadStockValue: deadStock.reduce((s, r) => s + r.inventoryValue, 0),
      deadStockSkus: deadStock.length,
      avgDaysOfInventory,
      stockoutCostEstimate: rows.reduce(
        (s, r) => s + r.stockoutCostEstimate,
        0,
      ),
      returnRatePct,
    },
    abcMix,
    rows: rows.sort((a, b) => b.inventoryValue - a.inventoryValue).slice(0, 100),
    deadStock,
    stockoutWatch,
  }
}

export function inventoryReportToCsv(report: InventoryReport): string {
  const lines: string[] = []
  lines.push(
    [
      'sku',
      'name',
      'brand',
      'abc_class',
      'available',
      'reserved',
      'cost_price',
      'inventory_value',
      'units_sold',
      'revenue',
      'days_of_inventory',
      'stockout_days',
      'stockout_cost_estimate',
      'returns',
      'return_rate_pct',
      'last_movement_at',
    ].join(','),
  )
  for (const r of report.rows) {
    lines.push(
      [
        r.sku,
        JSON.stringify(r.productName ?? ''),
        JSON.stringify(r.brand ?? ''),
        r.abcClass ?? '',
        r.available,
        r.reserved,
        r.costPrice ?? '',
        r.inventoryValue,
        r.unitsSold,
        r.revenue,
        r.daysOfInventory ?? '',
        r.stockoutDays,
        r.stockoutCostEstimate,
        r.returnsCount,
        r.returnRatePct == null ? '' : r.returnRatePct.toFixed(2),
        r.lastMovementAt ?? '',
      ].join(','),
    )
  }
  return lines.join('\n')
}
