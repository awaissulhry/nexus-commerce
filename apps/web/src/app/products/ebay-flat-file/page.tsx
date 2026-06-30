import EbayFlatFileClient from './EbayFlatFileClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  searchParams: Promise<{ marketplace?: string; familyId?: string }>
}

const DEFAULT_MARKETPLACE = 'IT'

export default async function EbayFlatFilePage({ searchParams }: PageProps) {
  // Rows are fetched client-side (SWR cache → instant on return visits, API on first visit).
  // The server component is now a trivial shell — it streams near-instantly so the
  // loading.tsx skeleton disappears in <50ms instead of waiting 200-800ms for a DB query.
  const { marketplace = DEFAULT_MARKETPLACE, familyId } = await searchParams

  return (
    <EbayFlatFileClient
      initialRows={[]}
      initialMarketplace={marketplace.toUpperCase()}
      familyId={familyId}
    />
  )
}
