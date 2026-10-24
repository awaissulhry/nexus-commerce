// /listings — the Listings page (2026-10-24: the readiness page took over the menu entry; the old page is
// `/listings/legacy`, docs/listings/LISTINGS-SWAP-2026-10-24.md). The Products page's frame (`products/next/layout.tsx`:
// its shell, rail and width), as /products itself uses it. The page is the client component; this file is the frame.
import type { Metadata } from 'next'
import ProductsNextLayout from '@/app/products/next/layout'
import { ListingReadinessClient } from './_readiness/ListingReadinessClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const metadata: Metadata = { title: 'Listings' }

export default function ListingsPage() {
  return (
    <ProductsNextLayout>
      <ListingReadinessClient />
    </ProductsNextLayout>
  )
}
