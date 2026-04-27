'use server'

import { revalidatePath } from 'next/cache'

const API_BASE = process.env.SYNC_API_URL || 'http://localhost:3001'

export async function triggerFullSync() {
  try {
    const res = await fetch(`${API_BASE}/listings/force-sync-ebay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })

    if (!res.ok) {
      const body = await res.text()
      return { success: false, error: `Sync failed (${res.status}): ${body}` }
    }

    const data = await res.json()
    revalidatePath('/engine/ebay')
    return { success: true, message: data.message || 'Sync completed' }
  } catch (error: any) {
    return { success: false, error: error?.message || 'Failed to connect to sync API' }
  }
}

export async function triggerAmazonCatalogSync() {
  try {
    const res = await fetch(`${API_BASE}/listings/sync-amazon-catalog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })

    if (!res.ok) {
      const body = await res.text()
      return { success: false, error: `Catalog sync failed (${res.status}): ${body}` }
    }

    const data = await res.json()
    revalidatePath('/engine/ebay')
    return {
      success: true,
      message: data.message || 'Catalog synced',
      details: {
        total: data.total,
        created: data.created,
        updated: data.updated,
        enriched: data.enriched,
      },
    }
  } catch (error: any) {
    return { success: false, error: error?.message || 'Failed to connect to sync API' }
  }
}
