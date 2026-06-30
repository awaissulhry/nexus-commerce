import { getBackendUrl } from '@/lib/backend-url'
import AmazonFlatFileClient from './AmazonFlatFileClient'
import NewTabClickPerf from '@/components/perf/NewTabClickPerf'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  searchParams: Promise<{ marketplace?: string; productType?: string; familyId?: string }>
}

const DEFAULT_MARKETPLACE = 'IT'
const DEFAULT_PRODUCT_TYPE = 'OUTERWEAR'

export default async function AmazonFlatFilePage({ searchParams }: PageProps) {
  const { marketplace = DEFAULT_MARKETPLACE, productType = DEFAULT_PRODUCT_TYPE, familyId } =
    await searchParams
  const backend = getBackendUrl()

  // Only fetch the manifest server-side (30-min cache, ~50ms). Rows are fetched
  // client-side from the SWR cache (instant on return visits) or the API directly
  // (first visit). This eliminates the 200-800ms no-store DB round-trip that was
  // blocking every navigation to this page.
  const manifestRes = await fetch(
    `${backend}/api/amazon/flat-file/template?marketplace=${marketplace}&productType=${productType}`,
    { next: { revalidate: 1800 } },
  ).catch(() => null)

  const manifest = manifestRes?.ok ? await manifestRes.json().catch(() => null) : null

  return (
    <>
      {familyId && (
        <NewTabClickPerf button="flatFile" productId={familyId} />
      )}
      <AmazonFlatFileClient
        initialManifest={manifest}
        initialRows={[]}
        initialMarketplace={marketplace.toUpperCase()}
        initialProductType={productType.toUpperCase()}
        familyId={familyId}
      />
    </>
  )
}
