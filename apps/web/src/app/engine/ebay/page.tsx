import { prisma } from '@nexus/database'
import PageHeader from '@/components/layout/PageHeader'
import EbaySyncClient from './EbaySyncClient'

export const dynamic = 'force-dynamic'

export interface EbaySyncProduct {
  id: string
  sku: string
  name: string
  amazonAsin: string | null
  ebayItemId: string | null
  ebayTitle: string | null
  basePrice: number
  totalStock: number
  lastSyncStatus: string | null
  lastSyncAt: string | null
}

export default async function EbaySyncPage() {
  const products = await prisma.product.findMany({
    include: {
      marketplaceSyncs: true,
      listings: {
        include: { channel: true },
      },
    },
    orderBy: { updatedAt: 'desc' },
  })

  const syncProducts: EbaySyncProduct[] = products.map((p: any) => {
    const ebaySync = p.marketplaceSyncs?.find((s: any) => s.channel === 'EBAY')
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      amazonAsin: p.amazonAsin,
      ebayItemId: p.ebayItemId,
      ebayTitle: p.ebayTitle,
      basePrice: Number(p.basePrice),
      totalStock: p.totalStock,
      lastSyncStatus: ebaySync?.lastSyncStatus ?? null,
      lastSyncAt: ebaySync?.lastSyncAt?.toISOString() ?? null,
    }
  })

  const totalProducts = syncProducts.length
  const linkedToEbay = syncProducts.filter((p) => p.ebayItemId).length
  const pendingSync = syncProducts.filter((p) => !p.ebayItemId && p.amazonAsin).length
  const failedSync = syncProducts.filter((p) => p.lastSyncStatus === 'FAILED').length

  return (
    <div>
      <PageHeader
        title="eBay Sync Control"
        subtitle="Manage Amazon → eBay product synchronization"
        breadcrumbs={[
          { label: 'Nexus Engine', href: '/engine/logs' },
          { label: 'eBay Sync Control' },
        ]}
      />

      <EbaySyncClient
        products={syncProducts}
        stats={{ totalProducts, linkedToEbay, pendingSync, failedSync }}
      />
    </div>
  )
}
