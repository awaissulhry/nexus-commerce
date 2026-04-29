import { NextRequest, NextResponse } from 'next/server'

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'https://nexusapi-production-b7bb.up.railway.app'

// POST /api/sync/amazon/catalog
// Triggers an Amazon catalog sync and returns a synthetic syncId.
export async function POST(_request: NextRequest) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/amazon/products/list`)

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
