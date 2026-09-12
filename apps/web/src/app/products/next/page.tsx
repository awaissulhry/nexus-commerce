// Legacy entry point. next.config.js redirects bookmarks to /products, including
// query parameters and workspace-prefixed URLs, before this page renders.

import { ProductsNextClient } from './ProductsNextClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default function ProductsNextPage() {
  return <ProductsNextClient />
}
