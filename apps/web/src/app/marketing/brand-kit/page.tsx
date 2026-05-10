// MC.10.1 — Brand Kit list page.
//
// Shows every BrandKit + every catalogue brand without a kit yet,
// so the operator can spin up a kit for a brand they already sell.

import { getBackendUrl } from '@/lib/backend-url'
import BrandKitListClient from './BrandKitListClient'
import type { BrandKitRow, BrandMetaRow } from './_lib/types'

export const dynamic = 'force-dynamic'

async function fetchData(): Promise<{
  kits: BrandKitRow[]
  brands: BrandMetaRow[]
  error: string | null
}> {
  const backend = getBackendUrl()
  try {
    const [kitsRes, brandsRes] = await Promise.all([
      fetch(`${backend}/api/brand-kits`, { cache: 'no-store' }),
      fetch(`${backend}/api/brand-kits/_meta/brands`, { cache: 'no-store' }),
    ])
    if (!kitsRes.ok)
      return {
        kits: [],
        brands: [],
        error: `Brand-kit API returned ${kitsRes.status}`,
      }
    const kitsBody = (await kitsRes.json()) as { kits: BrandKitRow[] }
    const brandsBody = brandsRes.ok
      ? ((await brandsRes.json()) as { brands: BrandMetaRow[] })
      : { brands: [] }
    return { kits: kitsBody.kits, brands: brandsBody.brands, error: null }
  } catch (err) {
    return {
      kits: [],
      brands: [],
      error: err instanceof Error ? err.message : 'Network error',
    }
  }
}

export default async function BrandKitListPage() {
  const { kits, brands, error } = await fetchData()
  const apiBase = getBackendUrl()
  return (
    <BrandKitListClient
      kits={kits}
      brands={brands}
      error={error}
      apiBase={apiBase}
    />
  )
}
