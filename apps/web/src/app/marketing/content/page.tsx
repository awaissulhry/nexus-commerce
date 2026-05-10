// MC.1.1 — DAM hub page shell.
//
// Replaces the W4.5/Phase-5 ComingSoonPage placeholder with the real
// /marketing/content surface. This commit lands the page shell:
// PageHeader, KPI strip (total assets / images / videos / storage /
// in-use / orphaned / needs-alt), and a toolbar scaffold that the
// MC.1.2–1.5 commits hang the library, filters, search, and detail
// drawer off of.
//
// The library list itself is intentionally an EmptyState placeholder
// in this commit — MC.1.2 (virtualized grid + list view) replaces it.
// Shipping the shell first keeps the diff readable + lets us verify
// the KPI strip + toolbar in isolation before introducing 10k-row
// virtualization.

import { Image as ImageIcon } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import ContentHubClient from './ContentHubClient'
import type { OverviewPayload } from './_lib/types'

export const dynamic = 'force-dynamic'

const EMPTY_OVERVIEW: OverviewPayload = {
  totalAssets: 0,
  productImageCount: 0,
  videoCount: 0,
  byType: {},
  storageBytes: 0,
  inUseCount: 0,
  orphanedCount: 0,
  needsAttention: { missingAltImages: 0 },
}

async function fetchOverview(): Promise<{
  data: OverviewPayload
  error: string | null
}> {
  const backend = getBackendUrl()
  try {
    const res = await fetch(`${backend}/api/assets/overview`, {
      cache: 'no-store',
    })
    if (!res.ok) {
      return {
        data: EMPTY_OVERVIEW,
        error: `Overview API returned ${res.status}`,
      }
    }
    const data = (await res.json()) as OverviewPayload
    return { data, error: null }
  } catch (err) {
    return {
      data: EMPTY_OVERVIEW,
      error: err instanceof Error ? err.message : 'Network error',
    }
  }
}

export default async function ContentHubPage() {
  const { data, error } = await fetchOverview()
  return (
    <ContentHubClient
      overview={data}
      overviewError={error}
      icon={<ImageIcon className="w-5 h-5" />}
    />
  )
}
