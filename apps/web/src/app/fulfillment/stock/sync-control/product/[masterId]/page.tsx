/**
 * SCV.2b — dedicated per-product Sync Control page.
 *
 * Opened in a new tab from a big family's "Open ↗" button. Shows ONLY that
 * master's variants → listings, with the full per-listing control surface
 * (and, from SCV.3, its own Excel export/import). Keeps the main list light.
 */

import PageHeader from '@/components/layout/PageHeader'
import ProductDetailClient from './ProductDetailClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function SyncControlProductPage({ params }: { params: Promise<{ masterId: string }> }) {
  const { masterId } = await params
  return (
    <div>
      <PageHeader
        title="Sync Control — Product"
        subtitle="Every listing for this product — modes, quantities, drift"
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Stock', href: '/fulfillment/stock' },
          { label: 'Sync Control', href: '/fulfillment/stock/sync-control' },
          { label: 'Product' },
        ]}
      />
      <ProductDetailClient masterId={masterId} />
    </div>
  )
}
