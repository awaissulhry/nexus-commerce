import { getBackendUrl } from '@/lib/backend-url'
import AmazonFlatFileClient from './AmazonFlatFileClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  searchParams: Promise<{ marketplace?: string; productType?: string; productId?: string }>
}

const DEFAULT_MARKETPLACE = 'IT'
const DEFAULT_PRODUCT_TYPE = 'OUTERWEAR'

export default async function AmazonFlatFilePage({ searchParams }: PageProps) {
  const { marketplace = DEFAULT_MARKETPLACE, productType = DEFAULT_PRODUCT_TYPE, productId } =
    await searchParams
  const backend = getBackendUrl()

  const rowsQs = new URLSearchParams({ marketplace, productType })
  if (productId) rowsQs.set('productId', productId)

  const [manifestRes, rowsRes] = await Promise.all([
    fetch(
      `${backend}/api/amazon/flat-file/template?marketplace=${marketplace}&productType=${productType}`,
      { cache: 'no-store' },
    ).catch(() => null),
    fetch(
      `${backend}/api/amazon/flat-file/rows?${rowsQs}`,
      { cache: 'no-store' },
    ).catch(() => null),
  ])

  const manifest = manifestRes?.ok ? await manifestRes.json().catch(() => null) : null
  const rowsJson = rowsRes?.ok ? await rowsRes.json().catch(() => null) : null
  const rows = rowsJson?.rows ?? []

  return (
    <AmazonFlatFileClient
      initialManifest={manifest}
      initialRows={rows}
      initialMarketplace={marketplace.toUpperCase()}
      initialProductType={productType.toUpperCase()}
      productId={productId}
    />
  )
}
