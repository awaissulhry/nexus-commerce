// MC.10.1 — Brand Kit edit page (per brand).
//
// Server-fetches the kit (or null if it doesn't exist yet) and hands
// off to the client editor. Operator can edit colors / fonts / logos
// / voice / notes; PUT auto-creates the kit on first save.

import { getBackendUrl } from '@/lib/backend-url'
import BrandKitEditClient from './BrandKitEditClient'
import type { BrandKitRow } from '../_lib/types'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ brand: string }>
}

async function fetchKit(brand: string): Promise<BrandKitRow | null> {
  const backend = getBackendUrl()
  try {
    const res = await fetch(
      `${backend}/api/brand-kits/${encodeURIComponent(brand)}`,
      { cache: 'no-store' },
    )
    if (res.status === 404) return null
    if (!res.ok) return null
    const data = (await res.json()) as { kit: BrandKitRow }
    return data.kit
  } catch {
    return null
  }
}

export default async function BrandKitEditPage({ params }: PageProps) {
  const { brand: rawBrand } = await params
  const brand = decodeURIComponent(rawBrand)
  const kit = await fetchKit(brand)
  const apiBase = getBackendUrl()
  return <BrandKitEditClient brand={brand} initial={kit} apiBase={apiBase} />
}
