import PageHeader from '@/components/layout/PageHeader'
import { getBackendUrl } from '@/lib/backend-url'
import BulkOperationsClient, { type BulkProduct } from './BulkOperationsClient'

export const dynamic = 'force-dynamic'

async function loadProducts(): Promise<BulkProduct[]> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/products/bulk-fetch`, {
      cache: 'no-store',
    })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data.products) ? data.products : []
  } catch {
    return []
  }
}

export default async function BulkOperationsPage() {
  const products = await loadProducts()

  return (
    <div className="space-y-3 -mx-6 -my-6 h-[calc(100vh-1.5rem)] flex flex-col">
      <div className="px-6 pt-6 flex-shrink-0">
        <PageHeader
          title="Bulk Operations"
          description={`${products.length} products · click any cell to edit (Phase B) · Cmd+S to save`}
        />
      </div>
      <BulkOperationsClient initialProducts={products} />
    </div>
  )
}
