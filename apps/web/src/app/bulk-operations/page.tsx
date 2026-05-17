import { getBackendUrl } from '@/lib/backend-url'
import UnifiedFlatFileClient from './UnifiedFlatFileClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  searchParams: Promise<{ productIds?: string; search?: string }>
}

export default async function BulkOperationsPage({ searchParams }: PageProps) {
  const { productIds, search } = await searchParams
  const backend = getBackendUrl()

  const qs = new URLSearchParams()
  if (productIds) qs.set('productIds', productIds)
  if (search) qs.set('search', search)

  const [tmplRes, rowsRes] = await Promise.all([
    fetch(`${backend}/api/flat-file/unified-template`, { cache: 'no-store' }).catch(() => null),
    fetch(`${backend}/api/flat-file/unified-rows?${qs.toString()}`, { cache: 'no-store' }).catch(() => null),
  ])

  const tmplJson = tmplRes?.ok ? await tmplRes.json().catch(() => null) : null
  const rowsJson = rowsRes?.ok ? await rowsRes.json().catch(() => null) : null

  return (
    <UnifiedFlatFileClient
      initialColumnGroups={tmplJson?.groups ?? []}
      initialRows={rowsJson?.rows ?? []}
      initialNextCursor={rowsJson?.nextCursor ?? null}
      initialProductIds={productIds}
      initialSearch={search}
    />
  )
}
