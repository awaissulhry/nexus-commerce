import Link from 'next/link'
import { Upload, Package } from 'lucide-react'
import type { InventoryItem } from '@/types/inventory'
import ManageInventoryClient from './manage/ManageInventoryClient'
import PageHeader from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { StatsBar } from '@/components/inventory/StatsBar'
import { getBackendUrl } from '@/lib/backend-url'

export const dynamic = 'force-dynamic'

interface ApiProduct {
  id: string
  sku: string
  name: string
  amazonAsin: string | null
  ebayItemId: string | null
  basePrice: string | number
  totalStock: number
  isParent: boolean
  parentId: string | null
  variationTheme: string | null
  fulfillmentChannel: string | null
  fulfillmentMethod: string | null
  shippingTemplate: string | null
  brand: string | null
  createdAt: string
  childCount?: number
}

interface InventoryStats {
  total: number
  synced: number
  lowStock: number
  lastSync: string | null
}

const FALLBACK_STATS: InventoryStats = { total: 0, synced: 0, lowStock: 0, lastSync: null }

async function loadInventory(): Promise<{
  items: InventoryItem[]
  stats: InventoryStats
}> {
  const backend = getBackendUrl()
  // Parallel: products list + stats — single round-trip
  const [productsRes, statsRes] = await Promise.all([
    fetch(`${backend}/api/amazon/products/list?topLevelOnly=1&limit=50`, {
      cache: 'no-store',
    }),
    fetch(`${backend}/api/inventory/stats`, { cache: 'no-store' }),
  ])

  const stats: InventoryStats = statsRes.ok ? await statsRes.json() : FALLBACK_STATS

  if (!productsRes.ok) {
    console.error(`[Inventory] products list returned ${productsRes.status}`)
    return { items: [], stats }
  }

  const data = await productsRes.json()
  const raw: ApiProduct[] = data.products ?? []

  const items: InventoryItem[] = raw.map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    asin: p.amazonAsin || null,
    ebayItemId: p.ebayItemId || null,
    imageUrl: null,
    price: Number(p.basePrice),
    stock: p.totalStock,
    status: p.totalStock <= 0 ? 'Out of Stock' : 'Active',
    isParent: p.isParent === true,
    childCount: p.childCount ?? 0,
    variationTheme: p.variationTheme || null,
    parentId: null,
    variationName: null,
    variationValue: null,
    brand: p.brand || null,
    fulfillment: p.fulfillmentChannel || p.fulfillmentMethod || null,
    fulfillmentChannel: (p.fulfillmentChannel as 'FBA' | 'FBM' | null) || null,
    shippingTemplate: p.shippingTemplate || null,
    createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
    condition: 'New',
  }))

  return { items, stats }
}

export default async function ProductsPage() {
  const { items, stats } = await loadInventory()

  return (
    <div className="space-y-5">
      <PageHeader
        title="Products"
        description="Master catalog across all channels"
        actions={
          <Link href="/inventory/upload">
            <Button variant="secondary" size="sm" icon={<Upload className="w-3.5 h-3.5" />}>
              Bulk Upload
            </Button>
          </Link>
        }
      />

      <StatsBar stats={stats} />

      {items.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No products yet"
          description="Import from Amazon to populate the master catalog, or upload a CSV to start manually."
          action={{ label: 'Bulk Upload', href: '/inventory/upload' }}
        />
      ) : (
        <ManageInventoryClient data={items} />
      )}
    </div>
  )
}
