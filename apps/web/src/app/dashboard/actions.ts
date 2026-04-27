'use server'

import { prisma } from '@nexus/database'
import { revalidatePath } from 'next/cache'

export async function refreshDashboardData() {
  try {
    revalidatePath('/dashboard')
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error?.message || 'Failed to refresh dashboard' }
  }
}

export async function getDashboardStats() {
  try {
    const [totalProducts, totalOrders, totalListings, totalChannels] = await Promise.all([
      prisma.product.count(),
      prisma.order.count(),
      prisma.listing.count(),
      prisma.channel.count(),
    ])

    const revenueResult = await prisma.order.aggregate({
      _sum: { totalAmount: true },
    })

    const totalRevenue = Number(revenueResult._sum.totalAmount || 0)

    return {
      success: true,
      data: { totalProducts, totalOrders, totalListings, totalChannels, totalRevenue },
    }
  } catch (error: any) {
    return { success: false, error: error?.message || 'Failed to fetch stats' }
  }
}
