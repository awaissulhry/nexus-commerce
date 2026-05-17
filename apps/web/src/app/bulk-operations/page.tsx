import { getBackendUrl } from '@/lib/backend-url'
import AmazonFlatFileClient from '@/app/products/amazon-flat-file/AmazonFlatFileClient'
import EbayFlatFileClient from '@/app/products/ebay-flat-file/EbayFlatFileClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  searchParams: Promise<{
    channel?: string
    marketplace?: string
    productType?: string
    familyId?: string
  }>
}

const DEFAULT_MARKETPLACE  = 'IT'
const DEFAULT_PRODUCT_TYPE = 'OUTERWEAR'

export default async function BulkOperationsPage({ searchParams }: PageProps) {
  const {
    channel: channelParam = 'amazon',
    marketplace = DEFAULT_MARKETPLACE,
    productType = DEFAULT_PRODUCT_TYPE,
    familyId,
  } = await searchParams

  const channel = channelParam === 'ebay' ? 'ebay' : 'amazon'
  const backend = getBackendUrl()
  const mp = marketplace.toUpperCase()
  const pt = productType.toUpperCase()

  if (channel === 'amazon') {
    const qs = new URLSearchParams({ marketplace: mp, productType: pt })
    if (familyId) qs.set('productId', familyId)

    const [manifestRes, rowsRes] = await Promise.all([
      fetch(`${backend}/api/amazon/flat-file/template?marketplace=${mp}&productType=${pt}`, { cache: 'no-store' }).catch(() => null),
      fetch(`${backend}/api/amazon/flat-file/rows?${qs}`, { cache: 'no-store' }).catch(() => null),
    ])
    const manifest = manifestRes?.ok ? await manifestRes.json().catch(() => null) : null
    const rowsJson = rowsRes?.ok    ? await rowsRes.json().catch(() => null)    : null

    return (
      <AmazonFlatFileClient
        initialManifest={manifest}
        initialRows={rowsJson?.rows ?? []}
        initialMarketplace={mp}
        initialProductType={pt}
        familyId={familyId}
      />
    )
  }

  // eBay
  const qs = new URLSearchParams()
  if (familyId) qs.set('familyId', familyId)

  const rowsRes  = await fetch(`${backend}/api/ebay/flat-file/rows?${qs}`, { cache: 'no-store' }).catch(() => null)
  const rowsJson = rowsRes?.ok ? await rowsRes.json().catch(() => null) : null

  return (
    <EbayFlatFileClient
      initialRows={rowsJson?.rows ?? []}
      initialMarketplace={mp}
      familyId={familyId}
    />
  )
}
