import { NextRequest, NextResponse } from 'next/server'

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'https://nexusapi-production-b7bb.up.railway.app'

// GET /api/inventory?limit=1000
export async function GET(request: NextRequest) {
  const limit = parseInt(request.nextUrl.searchParams.get('limit') ?? '1000', 10)

  try {
    const response = await fetch(`${BACKEND_URL}/api/amazon/products/list`, {
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
