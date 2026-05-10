// MC.8.2 — A+ Content list page.
//
// Server-rendered list with filter toolbar (marketplace + status +
// search) and a "New A+" CTA. Detail/builder lands at
// /marketing/aplus/[id] in MC.8.3.

import { getBackendUrl } from '@/lib/backend-url'
import AplusListClient from './AplusListClient'
import type { AplusContentRow } from './_lib/types'

export const dynamic = 'force-dynamic'

async function fetchList(): Promise<{
  items: AplusContentRow[]
  error: string | null
}> {
  const backend = getBackendUrl()
  try {
    const res = await fetch(`${backend}/api/aplus-content?limit=200`, {
      cache: 'no-store',
    })
    if (!res.ok) {
      return {
        items: [],
        error: `A+ Content API returned ${res.status}`,
      }
    }
    const data = (await res.json()) as { items: AplusContentRow[] }
    return { items: data.items ?? [], error: null }
  } catch (err) {
    return {
      items: [],
      error: err instanceof Error ? err.message : 'Network error',
    }
  }
}

export default async function AplusListPage() {
  const { items, error } = await fetchList()
  const apiBase = getBackendUrl()
  return (
    <AplusListClient items={items} error={error} apiBase={apiBase} />
  )
}
