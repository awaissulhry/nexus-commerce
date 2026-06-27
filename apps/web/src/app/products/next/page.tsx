// /products/next — additive, design-system-first rebuild of the products list.
// The existing /products page is 100% untouched.

import { ProductsNextClient } from './ProductsNextClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default function ProductsNextPage() {
  return <ProductsNextClient />
}
