// MC.9.1 — Brand Story list page.
//
// Server-rendered list at /marketing/brand-story. Builder lands at
// /marketing/brand-story/[id] in MC.9.2; for now the [id] page is a
// placeholder showing schema metadata.

import { getBackendUrl } from '@/lib/backend-url'
import BrandStoryListClient from './BrandStoryListClient'
import type { BrandStoryRow } from './_lib/types'

export const dynamic = 'force-dynamic'

async function fetchList(): Promise<{
  items: BrandStoryRow[]
  error: string | null
}> {
  const backend = getBackendUrl()
  try {
    const res = await fetch(`${backend}/api/brand-stories?limit=200`, {
      cache: 'no-store',
    })
    if (!res.ok) {
      return {
        items: [],
        error: `Brand Story API returned ${res.status}`,
      }
    }
    const data = (await res.json()) as { items: BrandStoryRow[] }
    return { items: data.items ?? [], error: null }
  } catch (err) {
    return {
      items: [],
      error: err instanceof Error ? err.message : 'Network error',
    }
  }
}

export default async function BrandStoryListPage() {
  const { items, error } = await fetchList()
  const apiBase = getBackendUrl()
  return (
    <BrandStoryListClient items={items} error={error} apiBase={apiBase} />
  )
}
