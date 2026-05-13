import { getBackendUrl } from '@/lib/backend-url'
import EbayFlatFileClient from './EbayFlatFileClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  searchParams: Promise<{ marketplace?: string; familyId?: string }>
}

const DEFAULT_MARKETPLACE = 'IT'

export default async function EbayFlatFilePage({ searchParams }: PageProps) {
  // marketplace is retained as initial context for category schema calls,
  // but rows are now all-market (one row per product, flat per-market fields).
  const { marketplace = DEFAULT_MARKETPLACE, familyId } = await searchParams
  const backend = getBackendUrl()

  const qs = new URLSearchParams()
  if (familyId) qs.set('familyId', familyId)

  const rowsRes = await fetch(
    `${backend}/api/ebay/flat-file/rows?${qs.toString()}`,
    { cache: 'no-store' },
  ).catch(() => null)

  const rowsJson = rowsRes?.ok ? await rowsRes.json().catch(() => null) : null
  const rows = rowsJson?.rows ?? []

  return (
    <EbayFlatFileClient
      initialRows={rows}
      initialMarketplace={marketplace.toUpperCase()}
      familyId={familyId}
    />
  )
}
