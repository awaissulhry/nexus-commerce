import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/catalog/products/bulk
 * Proxy to backend: POST http://localhost:3001/api/catalog/products/bulk
 * Create master product with variations and channel listings in a single transaction
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    console.log('📤 [BULK ROUTE] Proxying request to backend');
    console.log('📤 [BULK ROUTE] Payload:', JSON.stringify(body, null, 2));

    const response = await fetch('http://localhost:3001/api/catalog/products/bulk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const data = await response.json()

    console.log('📥 [BULK ROUTE] Response status:', response.status);
    console.log('📥 [BULK ROUTE] Response data:', JSON.stringify(data, null, 2));

    return NextResponse.json(data, { status: response.status })
  } catch (error) {
    console.error('Error creating bulk product:', error)
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'PROXY_ERROR',
          message: error instanceof Error ? error.message : 'Failed to create bulk product',
        },
      },
      { status: 500 }
    )
  }
}
