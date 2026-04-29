import { NextRequest, NextResponse } from 'next/server'
import { getBackendUrl } from '@/lib/backend-url'

// POST /api/sync/amazon/catalog
// Triggers an Amazon catalog sync and returns a synthetic syncId.
export async function POST(_request: NextRequest) {
  try {
    const response = await fetch(`${getBackendUrl()}/api/amazon/products/list`)

    if (!response.ok) {
      throw new Error(`Backend returned ${response.status}`)
    }

    const data = await response.json()
    const syncId = Date.now().toString()

    return NextResponse.json({
      success: true,
      data: {
        syncId,
        synced: data.count ?? data.products?.length ?? 0,
        message: `Fetched ${data.count ?? 0} products from Amazon`,
      },
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Sync failed' },
      { status: 500 }
    )
  }
}
