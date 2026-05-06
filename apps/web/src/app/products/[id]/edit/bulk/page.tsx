import { notFound } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import BulkEditClient from './BulkEditClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ProductBulkEditPage({ params }: PageProps) {
  const { id } = await params
  const backend = getBackendUrl()

  const productRes = await fetch(`${backend}/api/inventory/${id}`, {
    cache: 'no-store',
  })
  if (productRes.status === 404) notFound()
  if (!productRes.ok) {
    throw new Error(`Failed to load product: HTTP ${productRes.status}`)
  }
  const product = await productRes.json()

  const productTypeQs = product.productType
    ? `?productTypes=${encodeURIComponent(product.productType)}`
    : ''

  // Variants + listings + static registry fields up front. Listings are
  // needed both for the marketplace tabs (the client refetches anyway)
  // AND so we can pick a representative AMAZON marketplace to drive the
  // master-tab schema fetch — that's how every required + optional
  // Amazon attribute lands as an editable column on the master tab.
  const [childrenRes, fieldsRes, listingsRes] = await Promise.all([
    fetch(`${backend}/api/products/${id}/children`, {
      cache: 'no-store',
    }),
    fetch(`${backend}/api/pim/fields${productTypeQs}`, {
      cache: 'no-store',
    }),
    fetch(`${backend}/api/products/${id}/all-listings`, {
      cache: 'no-store',
    }),
  ])

  const childrenJson = childrenRes.ok ? await childrenRes.json() : { children: [] }
  const fieldsJson = fieldsRes.ok ? await fieldsRes.json() : { fields: [] }
  const listingsByChannel: Record<string, Array<{ channel: string; marketplace: string }>> =
    listingsRes.ok ? await listingsRes.json() : {}

  // Find a representative AMAZON marketplace. First any AMAZON listing,
  // then fall back to 'IT' (Xavia's primary market) so the master tab
  // still surfaces the full schema even when nothing is published yet.
  let masterSchemaFields: unknown[] = []
  if (product.productType) {
    const amazonListings = (listingsByChannel?.AMAZON ?? []) as Array<{
      channel: string
      marketplace: string
    }>
    const repMarketplace = amazonListings[0]?.marketplace ?? 'IT'
    try {
      const url = new URL(
        `${backend}/api/products/${id}/listings/AMAZON/${repMarketplace}/schema`,
      )
      url.searchParams.set('all', '1')
      const res = await fetch(url.toString(), { cache: 'no-store' })
      if (res.ok) {
        const json = await res.json()
        masterSchemaFields = (json.fields ?? []) as unknown[]
      }
    } catch {
      /* non-fatal — master tab falls back to the registry-only column
       * set when the schema fetch fails (e.g. SP-API unconfigured) */
    }
  }

  return (
    <BulkEditClient
      product={product}
      childrenList={childrenJson.children ?? []}
      fields={fieldsJson.fields ?? []}
      masterSchemaFields={masterSchemaFields as any}
    />
  )
}
