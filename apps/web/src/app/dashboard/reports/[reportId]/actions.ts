'use server'

import { prisma } from '@nexus/database'

interface ReportSection {
  title: string
  type: 'table' | 'stat' | 'chart' | 'text'
  data: any
}

export async function getReportDetail(reportId: string) {
  try {
    const sections: ReportSection[] = []

    switch (reportId) {
      case 'sales-summary': {
        const [totalOrders, revenueResult, recentOrders] = await Promise.all([
          prisma.order.count(),
          prisma.order.aggregate({ _sum: { totalAmount: true }, _avg: { totalAmount: true } }),
          prisma.order.findMany({
            take: 20,
            orderBy: { createdAt: 'desc' },
            select: { id: true, amazonOrderId: true, status: true, totalAmount: true, buyerName: true, createdAt: true },
          }),
        ])

        sections.push({
          title: 'Summary',
          type: 'stat',
          data: {
            totalOrders,
            totalRevenue: Number(revenueResult._sum.totalAmount || 0),
            avgOrderValue: Number(revenueResult._avg.totalAmount || 0),
          },
        })

        sections.push({
          title: 'Recent Orders',
          type: 'table',
          data: {
            columns: ['Order ID', 'Buyer', 'Status', 'Amount', 'Date'],
            rows: recentOrders.map((o: any) => [
              o.amazonOrderId,
              o.buyerName || '—',
              o.status,
              Number(o.totalAmount).toLocaleString('en-US', { style: 'currency', currency: 'USD' }),
              o.createdAt.toLocaleDateString('en-US'),
            ]),
          },
        })
        break
      }

      case 'inventory-health': {
        const products = await prisma.product.findMany({
          select: { id: true, sku: true, name: true, totalStock: true, basePrice: true },
          orderBy: { totalStock: 'asc' },
          take: 50,
        })

        const outOfStock = products.filter((p) => p.totalStock === 0).length
        const lowStock = products.filter((p) => p.totalStock > 0 && p.totalStock < 10).length
        const healthy = products.filter((p) => p.totalStock >= 10).length

        sections.push({
          title: 'Stock Health Summary',
          type: 'stat',
          data: { outOfStock, lowStock, healthy, totalProducts: products.length },
        })

        sections.push({
          title: 'Products by Stock Level',
          type: 'table',
          data: {
            columns: ['SKU', 'Name', 'Stock', 'Price', 'Status'],
            rows: products.map((p) => [
              p.sku,
              p.name,
              p.totalStock.toString(),
              Number(p.basePrice).toLocaleString('en-US', { style: 'currency', currency: 'USD' }),
              p.totalStock === 0 ? 'OUT OF STOCK' : p.totalStock < 10 ? 'LOW' : 'HEALTHY',
            ]),
          },
        })
        break
      }

      case 'channel-performance': {
        const channels = await prisma.channel.findMany({
          include: { _count: { select: { listings: true, orders: true } } },
        })

        sections.push({
          title: 'Channel Overview',
          type: 'table',
          data: {
            columns: ['Channel', 'Type', 'Listings', 'Orders'],
            rows: channels.map((ch: any) => [
              ch.name,
              ch.type,
              ch._count.listings.toString(),
              ch._count.orders.toString(),
            ]),
          },
        })
        break
      }

      case 'listing-audit': {
        const listings = await prisma.listing.findMany({
          take: 50,
          include: { product: { select: { name: true, sku: true } }, channel: { select: { name: true } } },
        })

        sections.push({
          title: 'Listing Audit',
          type: 'table',
          data: {
            columns: ['Product', 'SKU', 'Channel', 'Price', 'Status'],
            rows: listings.map((l: any) => [
              l.product?.name || '—',
              l.product?.sku || '—',
              l.channel?.name || '—',
              Number(l.channelPrice || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' }),
              l.status || 'Unknown',
            ]),
          },
        })
        break
      }

      default: {
        sections.push({
          title: 'Report Not Found',
          type: 'text',
          data: { message: `Report "${reportId}" is not yet implemented. Check back soon.` },
        })
      }
    }

    // Report metadata
    const reportNames: Record<string, string> = {
      'sales-summary': 'Sales Summary',
      'inventory-health': 'Inventory Health Report',
      'channel-performance': 'Channel Performance',
      'listing-audit': 'Listing Audit',
      'pricing-analysis': 'Pricing Analysis',
      'returns-analysis': 'Returns Analysis',
      'fulfillment-metrics': 'Fulfillment Metrics',
      'tax-summary': 'Tax Summary',
    }

    return {
      success: true,
      data: {
        reportId,
        name: reportNames[reportId] || reportId,
        generatedAt: new Date().toISOString(),
        sections,
      },
    }
  } catch (error: any) {
    return { success: false, error: error?.message || 'Failed to generate report' }
  }
}
