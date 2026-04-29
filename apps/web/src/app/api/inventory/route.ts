import { NextRequest, NextResponse } from 'next/server'
import { getBackendUrl } from '@/lib/backend-url'

// GET /api/inventory?limit=1000
export async function GET(request: NextRequest) {
  const limit = parseInt(request.nextUrl.searchParams.get('limit') ?? '1000', 10)

  try {
    const response = await fetch(`${getBackendUrl()}/api/amazon/products/list`, {
      cache: 'no-store',
    })

    if (!response.ok) {
      throw new Error(`Backend returned ${response.status}`)
    }

    const data = await response.json()
    const products = (data.products ?? []).slice(0, limit)

    return NextResponse.json({
      success: true,
      data: products,
      total: data.count ?? products.length,
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch inventory' },
      { status: 500 }
    )
  }
}
