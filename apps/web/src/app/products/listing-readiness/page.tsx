// /products/listing-readiness — the Products page's frame (`next/layout.tsx`: its shell, rail and width), as
// /products itself uses it. The page is the client component; this file is only the frame.
import ProductsNextLayout from '../next/layout'
import { ListingReadinessClient } from './ListingReadinessClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default function ListingReadinessPage() {
  return (
    <ProductsNextLayout>
      <ListingReadinessClient />
    </ProductsNextLayout>
  )
}
