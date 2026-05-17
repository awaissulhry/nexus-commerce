import { getBackendUrl } from '@/lib/backend-url'
import BulkOpsChannelWrapper from './BulkOpsChannelWrapper'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  searchParams: Promise<{
    channel?: string
    marketplace?: string
    productType?: string
  }>
}

const DEFAULT_MARKETPLACE   = 'IT'
const DEFAULT_PRODUCT_TYPE  = 'OUTERWEAR'

export default async function BulkOperationsPage({ searchParams }: PageProps) {
  const {
    channel: channelParam = 'amazon',
    marketplace = DEFAULT_MARKETPLACE,
    productType = DEFAULT_PRODUCT_TYPE,
  } = await searchParams

  const channel  = channelParam === 'ebay' ? 'ebay' : 'amazon'
  const backend  = getBackendUrl()
  const mp       = marketplace.toUpperCase()
  const pt       = productType.toUpperCase()

  if (channel === 'amazon') {
    const qs = new URLSearchParams({ marketplace: mp, productType: pt })
    const [manifestRes, rowsRes] = await Promise.all([
      fetch(`${backend}/api/amazon/flat-file/template?marketplace=${mp}&productType=${pt}`, { cache: 'no-store' }).catch(() => null),
      fetch(`${backend}/api/amazon/flat-file/rows?${qs}`, { cache: 'no-store' }).catch(() => null),
    ])
    const manifest = manifestRes?.ok ? await manifestRes.json().catch(() => null) : null
    const rowsJson = rowsRes?.ok    ? await rowsRes.json().catch(() => null)    : null

    return (
      <BulkOpsChannelWrapper
        channel="amazon"
        amazonManifest={manifest}
        amazonRows={rowsJson?.rows ?? []}
        amazonMarketplace={mp}
        amazonProductType={pt}
        ebayRows={[]}
        ebayMarketplace={DEFAULT_MARKETPLACE}
      />
    )
  }

  // eBay
  const rowsRes  = await fetch(`${backend}/api/ebay/flat-file/rows`, { cache: 'no-store' }).catch(() => null)
  const rowsJson = rowsRes?.ok ? await rowsRes.json().catch(() => null) : null

  return (
    <BulkOpsChannelWrapper
      channel="ebay"
      amazonManifest={null}
      amazonRows={[]}
      amazonMarketplace={DEFAULT_MARKETPLACE}
      amazonProductType={DEFAULT_PRODUCT_TYPE}
      ebayRows={rowsJson?.rows ?? []}
      ebayMarketplace={mp}
    />
  )
}
