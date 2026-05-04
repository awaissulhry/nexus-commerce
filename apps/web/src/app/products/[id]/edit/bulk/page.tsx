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

  // Parent + children + dynamic field set in parallel. Variants come
  // from /amazon/products/:id/children (same source the edit page uses
  // for its variations tab); fields registry includes any attr_* keys
  // applicable to the master productType so the spreadsheet surfaces
  // them as editable columns alongside the static master fields.
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

  const [childrenRes, fieldsRes] = await Promise.all([
    fetch(`${backend}/api/amazon/products/${id}/children`, {
      cache: 'no-store',
    }),
    fetch(`${backend}/api/pim/fields${productTypeQs}`, {
      cache: 'no-store',
    }),
  ])

  const childrenJson = childrenRes.ok ? await childrenRes.json() : { children: [] }
  const fieldsJson = fieldsRes.ok ? await fieldsRes.json() : { fields: [] }

  return (
    <BulkEditClient
      product={product}
      childrenList={childrenJson.children ?? []}
      fields={fieldsJson.fields ?? []}
    />
  )
}
