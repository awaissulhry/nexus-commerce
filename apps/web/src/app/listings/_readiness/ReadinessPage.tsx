// The Listings page in the Products page's frame (`products/next/layout.tsx`: its shell, rail and width), as /products
// itself uses it: `/listings`, and since 2026-10-24 each store page with its lock (`readinessScope.ts`). The page is the
// client component; this is the frame.
import { notFound } from 'next/navigation'
import ProductsNextLayout from '@/app/products/next/layout'
import { ListingReadinessClient } from './ListingReadinessClient'
import { marketOfSegment, type ReadinessLock, type ReadinessStore } from './readinessScope'

export function ReadinessPage({ lock }: { lock: ReadinessLock | null }) {
  return (
    <ProductsNextLayout>
      <ListingReadinessClient lock={lock} />
    </ProductsNextLayout>
  )
}

/** `/listings/<store>/<market>`: the market is two letters (`gb` is the UK), or the page does not exist. */
export async function marketLock(channel: ReadinessStore, params: Promise<{ market: string }>): Promise<ReadinessLock> {
  const marketplace = marketOfSegment((await params).market)
  if (!marketplace) notFound()
  return { channel, marketplace }
}
