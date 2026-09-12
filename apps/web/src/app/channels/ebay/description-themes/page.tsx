'use client'

import { useSearchParams } from 'next/navigation'
import { useRouter } from '@/lib/workspaces/navigation'
import { PageHeader } from '@/design-system/patterns'
import { EbayDescriptionStudio } from '@/app/products/ebay-flat-file/DescriptionStudio'

export default function DescriptionThemesPage() {
  const router = useRouter()
  const search = useSearchParams()
  return <>
    <PageHeader title="Description themes" subtitle="Reusable eBay presentation, usage, versions and targeted listing updates" />
    <div style={{ height: 'calc(100dvh - 180px)', minHeight: 560 }}>
      <EbayDescriptionStudio open embedded marketplace={search.get('market') ?? 'IT'}
        sampleProductId={search.get('product') ?? undefined} onClose={() => router.push('/products')} />
    </div>
  </>
}
