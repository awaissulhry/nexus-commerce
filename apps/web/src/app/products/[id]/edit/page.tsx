import { notFound } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import ProductEditClient from './ProductEditClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ProductEditPage({ params }: PageProps) {
  const { id } = await params
  const backend = getBackendUrl()

  // PERF — block render only on what the operator's first view (the Master
  // tab) actually needs: the product itself, its children (variant badge +
  // matrix), and the marketplaces list. all-listings is the SLOWEST fetch
  // (up to 9s cold) and isn't visible until a channel tab is opened, so it
  // is NOT gated here — ProductEditClient fetches it client-side on mount
  // into `clientListings`, streaming it in while the operator reads Master.
  const [productRes, marketplacesRes, childrenRes] = await Promise.all([
    // P2 #21 — moved from legacy /api/inventory/:id to canonical
    // /api/products/:id; same response shape, no per-call change.
    fetch(`${backend}/api/products/${id}`, { cache: 'no-store' }),
    fetch(`${backend}/api/marketplaces/grouped`, { cache: 'no-store' }),
    fetch(`${backend}/api/products/${id}/children`, { cache: 'no-store' }),
  ])

  if (productRes.status === 404) notFound()
  if (!productRes.ok) {
    throw new Error(`Failed to load product: HTTP ${productRes.status}`)
  }

  const product = await productRes.json()
  // Streamed client-side on mount (see comment above) — start empty so the
  // page renders without waiting on all-listings.
  const listings = {}
  const marketplaces = marketplacesRes.ok ? await marketplacesRes.json() : {}
  const childrenJson = childrenRes.ok ? await childrenRes.json() : { children: [] }
  const childrenList = childrenJson.children ?? []

  // When this product is a variant (child), fetch the family context:
  // parent product, all siblings, and parent's channel listings so we
  // can surface per-channel parent IDs (Amazon ASIN, eBay item ID, etc.)
  let parentProduct: any = null
  let siblings: any[] = []
  let parentListings: Record<string, any[]> = {}

  if (product.parentId) {
    const [parentRes, siblingsRes, parentListingsRes] = await Promise.all([
      fetch(`${backend}/api/products/${product.parentId}`, { cache: 'no-store' }),
      fetch(`${backend}/api/products/${product.parentId}/children`, { cache: 'no-store' }),
      fetch(`${backend}/api/products/${product.parentId}/all-listings`, { cache: 'no-store' }),
    ])
    if (parentRes.ok) parentProduct = await parentRes.json()
    if (siblingsRes.ok) {
      const json = await siblingsRes.json()
      siblings = json.children ?? []
    }
    if (parentListingsRes.ok) parentListings = await parentListingsRes.json()
  }

  return (
    <ProductEditClient
      product={product}
      listings={listings}
      marketplaces={marketplaces}
      childrenList={childrenList}
      parentProduct={parentProduct}
      siblings={siblings}
      parentListings={parentListings}
    />
  )
}
