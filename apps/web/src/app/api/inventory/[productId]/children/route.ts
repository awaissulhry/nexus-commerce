import { NextRequest, NextResponse } from 'next/server'
import { getBackendUrl } from '@/lib/backend-url'
import type { InventoryItem } from '@/types/inventory'

// GET /api/inventory/:productId/children
// Lazy-loads children for a parent product row.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ productId: string }> }
) {
  const { productId } = await params

  try {
    const res = await fetch(
      `${getBackendUrl()}/api/amazon/products/${productId}/children`,
      { cache: 'no-store' }
    )

    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: `Backend returned ${res.status}` },
        { status: res.status }
      )
    }

    const data = await res.json()
    const raw: any[] = data.children ?? []

    const deriveStatus = (stock: number): InventoryItem['status'] =>
      stock <= 0 ? 'Out of Stock' : 'Active'

    const children: InventoryItem[] = raw.map((c) => ({
      id: c.id,
      sku: c.sku,
      name: c.name,
      asin: c.amazonAsin || null,
      ebayItemId: c.ebayItemId || null,
      imageUrl: null,
      price: Number(c.basePrice),
      stock: c.totalStock,
      status: deriveStatus(c.totalStock),
      isParent: false,
      childCount: 0,
      variationTheme: c.variationTheme || null,
      parentId: c.parentId || null,
      variationName: c.variationTheme || null,
      variationValue: null,
      // Backend sets c.variations from categoryAttributes.variations
      // (see /api/amazon/products/:id/children handler).
      variations: (c.variations as Record<string, string> | null | undefined) ?? null,
      brand: null,
      fulfillment: c.fulfillmentMethod || c.fulfillmentChannel || null,
      fulfillmentChannel: (c.fulfillmentChannel as 'FBA' | 'FBM' | null) || null,
      shippingTemplate: c.shippingTemplate || null,
      createdAt: c.createdAt ? new Date(c.createdAt).toISOString() : null,
      condition: 'New',
    }))

    return NextResponse.json({ success: true, children })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch children' },
      { status: 500 }
    )
  }
}
