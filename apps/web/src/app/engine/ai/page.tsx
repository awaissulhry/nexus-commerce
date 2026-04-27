import { prisma } from '@nexus/database'
import PageHeader from '@/components/layout/PageHeader'
import AIListingClient from './AIListingClient'

export const dynamic = 'force-dynamic'

export interface AIProduct {
  id: string
  sku: string
  name: string
  amazonAsin: string | null
  ebayItemId: string | null
  ebayTitle: string | null
  brand: string | null
  basePrice: number
  totalStock: number
  bulletPoints: string[]
  hasImages: boolean
  hasVariations: boolean
}

export default async function AIListingGeneratorPage() {
  const products = await (prisma as any).product.findMany({
    include: {
      images: { select: { id: true } },
      variations: { select: { id: true } },
    },
    orderBy: { name: 'asc' },
  })

  const aiProducts: AIProduct[] = products.map((p: any) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    amazonAsin: p.amazonAsin,
    ebayItemId: p.ebayItemId,
    ebayTitle: p.ebayTitle,
    brand: p.brand,
    basePrice: Number(p.basePrice),
    totalStock: p.totalStock,
    bulletPoints: p.bulletPoints ?? [],
    hasImages: (p.images?.length ?? 0) > 0,
    hasVariations: (p.variations?.length ?? 0) > 0,
  }))

  return (
    <div>
      <PageHeader
        title="AI Listing Generator"
        subtitle="Generate optimized eBay listings using Gemini AI"
        breadcrumbs={[
          { label: 'Nexus Engine', href: '/engine/logs' },
          { label: 'AI Listing Generator' },
        ]}
      />

      <AIListingClient products={aiProducts} />
    </div>
  )
}
