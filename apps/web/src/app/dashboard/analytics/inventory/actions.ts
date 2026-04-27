'use server'

import { prisma } from '@nexus/database'

export async function getInventoryAnalytics() {
  try {
    const products = await (prisma as any).product.findMany({
      select: {
        id: true,
        sku: true,
        name: true,
        totalStock: true,
        basePrice: true,
        _count: { select: { variations: true, images: true } },
      },
    })

    // Stock distribution
    let outOfStock = 0
    let lowStock = 0
    let healthyStock = 0
    let overStock = 0
    let totalStockValue = 0

    for (const p of products) {
      const stock = p.totalStock
      const price = Number(p.basePrice || 0)
      totalStockValue += stock * price

      if (stock === 0) outOfStock++
      else if (stock < 10) lowStock++
      else if (stock > 500) overStock++
      else healthyStock++
    }

    // Top stocked products
    const topStocked = [...products]
      .sort((a: any, b: any) => b.totalStock - a.totalStock)
      .slice(0, 10)
      .map((p: any) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        totalStock: p.totalStock,
        stockValue: Number(p.basePrice || 0) * p.totalStock,
        variationCount: p._count?.variations ?? 0,
      }))

    // Low stock alerts
    const lowStockProducts = products
      .filter((p: any) => p.totalStock > 0 && p.totalStock < 10)
      .sort((a: any, b: any) => a.totalStock - b.totalStock)
      .slice(0, 20)
      .map((p: any) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        totalStock: p.totalStock,
      }))

    // Out of stock products
    const outOfStockProducts = products
      .filter((p: any) => p.totalStock === 0)
      .slice(0, 20)
      .map((p: any) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
      }))

    // Stock value by price tier
    const tiers = [
      { label: '$0–$25', min: 0, max: 25, count: 0, value: 0 },
      { label: '$25–$50', min: 25, max: 50, count: 0, value: 0 },
      { label: '$50–$100', min: 50, max: 100, count: 0, value: 0 },
      { label: '$100–$250', min: 100, max: 250, count: 0, value: 0 },
      { label: '$250+', min: 250, max: Infinity, count: 0, value: 0 },
    ]
    for (const p of products) {
      const price = Number((p as any).basePrice || 0)
      for (const tier of tiers) {
        if (price >= tier.min && price < tier.max) {
          tier.count++
          tier.value += price * (p as any).totalStock
          break
        }
      }
    }

    return {
      success: true,
      data: {
        totalProducts: products.length,
        totalUnits: products.reduce((sum: number, p: any) => sum + p.totalStock, 0),
        totalStockValue,
        stockDistribution: { outOfStock, lowStock, healthyStock, overStock },
        topStocked,
        lowStockProducts,
        outOfStockProducts,
        priceTiers: tiers.map((t) => ({ label: t.label, count: t.count, value: t.value })),
      },
    }
  } catch (error: any) {
    return { success: false, error: error?.message || 'Failed to fetch inventory analytics' }
  }
}
