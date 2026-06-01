/** Ads Console — Advertised products (Amazon-faithful). Server-fetches the roster. */
import type { Metadata } from 'next'
import { getBackendUrl } from '@/lib/backend-url'
import { ProductsTable } from './ProductsTable'

export const metadata: Metadata = { title: 'Products | Ads Console' }
export const dynamic = 'force-dynamic'

async function getInitial() {
  try {
    const r = await fetch(`${getBackendUrl()}/api/advertising/by-product?windowDays=30&limit=300`, { cache: 'no-store' })
    if (!r.ok) return []
    const d = await r.json()
    return d.rows ?? []
  } catch {
    return []
  }
}

export default async function AdsConsoleProductsPage() {
  const rows = await getInitial()
  return <ProductsTable initial={rows} />
}
