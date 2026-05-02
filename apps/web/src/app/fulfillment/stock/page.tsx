import { Warehouse } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { StockClient, type StockRow } from './StockClient'

export const dynamic = 'force-dynamic'

async function loadStock(): Promise<StockRow[]> {
  try {
    const res = await fetch(
      `${getBackendUrl()}/api/fulfillment/stock-overview?limit=500`,
      { cache: 'no-store' }
    )
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data.items) ? data.items : []
  } catch {
    return []
  }
}

export default async function StockOverviewPage() {
  const rows = await loadStock()

  return (
    <div className="space-y-5">
      <PageHeader
        title="Stock Overview"
        description="Inventory levels across all fulfillment channels"
      />
      {rows.length === 0 ? (
        <EmptyState
          icon={Warehouse}
          title="No stock data yet"
          description="Import products from Amazon or upload a CSV to populate the catalog. Stock levels will appear once products are linked to a fulfillment channel."
          action={{ label: 'Go to Catalog', href: '/products' }}
        />
      ) : (
        <StockClient rows={rows} />
      )}
    </div>
  )
}
