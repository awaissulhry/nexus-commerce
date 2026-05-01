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

  // Fetch all four payloads in parallel
  const [productRes, listingsRes, marketplacesRes, childrenRes] = await Promise.all([
    fetch(`${backend}/api/inventory/${id}`, { cache: 'no-store' }),
    fetch(`${backend}/api/products/${id}/all-listings`, { cache: 'no-store' }),
    fetch(`${backend}/api/marketplaces/grouped`, { cache: 'no-store' }),
    fetch(`${backend}/api/inventory/${id}/children`, { cache: 'no-store' }),
  ])

  if (productRes.status === 404) notFound()
  if (!productRes.ok) {
    throw new Error(`Failed to load product: HTTP ${productRes.status}`)
  }

  const product = await productRes.json()
  const listings = listingsRes.ok ? await listingsRes.json() : {}
  const marketplaces = marketplacesRes.ok ? await marketplacesRes.json() : {}
  const childrenJson = childrenRes.ok ? await childrenRes.json() : { children: [] }
  const childrenList = childrenJson.children ?? []

  return (
    <ProductEditClient
      product={product}
      listings={listings}
      marketplaces={marketplaces}
      childrenList={childrenList}
    />
  )
}
